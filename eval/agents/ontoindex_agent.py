"""
OntoIndex-Enhanced Agent for SWE-bench Evaluation

Extends mini-swe-agent's DefaultAgent with:
1. Native augment mode: OntoIndex tools via eval-server + grep enrichment (recommended)
2. Native mode: OntoIndex tools via eval-server only
3. Baseline mode: Pure mini-swe-agent (no OntoIndex — control group)

The agent class itself is minimal — the heavy lifting is in:
- Prompt selection (system + instance templates per mode)
- Observation post-processing (grep result augmentation)
- Metrics tracking (which tools the agent actually uses)

Template structure (matches mini-swe-agent's expectations):
  system_template  → system message: persona + format rules + tool reference
  instance_template → first user message: task + workflow + rules + examples
"""

import logging
import re
import time
from enum import Enum
from pathlib import Path

from constants import AUGMENT_TIMEOUT_SECONDS
from minisweagent import Environment, Model
from minisweagent.agents.default import AgentConfig, DefaultAgent
from tool_registry import BINARIES_BY_KEY, TOOL_METRIC_KEYS

logger = logging.getLogger("ontoindex_agent")

PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


class OntoIndexMode(str, Enum):
    """Evaluation modes for OntoIndex integration."""
    BASELINE = "baseline"               # No OntoIndex — pure mini-swe-agent
    NATIVE = "native"                   # OntoIndex tools via eval-server
    NATIVE_AUGMENT = "native_augment"   # Native tools + grep enrichment (recommended)


class OntoIndexAgentConfig(AgentConfig):
    """Extended config for OntoIndex evaluation agent."""
    ontoindex_mode: OntoIndexMode = OntoIndexMode.BASELINE
    augment_timeout: float = AUGMENT_TIMEOUT_SECONDS
    augment_min_pattern_length: int = 3
    track_ontoindex_usage: bool = True


class OntoIndexAgent(DefaultAgent):
    """
    Agent that optionally enriches its capabilities with OntoIndex code intelligence.

    In BASELINE mode, behaves identically to DefaultAgent.
    In NATIVE mode, OntoIndex tools are available as bash commands via eval-server.
    In NATIVE_AUGMENT mode, OntoIndex tools + automatic grep result enrichment.
    """

    def __init__(self, model: Model, env: Environment, *, config_class: type = OntoIndexAgentConfig, **kwargs):
        mode = kwargs.get("ontoindex_mode", OntoIndexMode.BASELINE)
        if isinstance(mode, str):
            mode = OntoIndexMode(mode)

        # Load system template
        system_file = PROMPTS_DIR / f"system_{mode.value}.jinja"
        if system_file.exists() and "system_template" not in kwargs:
            kwargs["system_template"] = system_file.read_text()

        # Load instance template
        instance_file = PROMPTS_DIR / f"instance_{mode.value}.jinja"
        if instance_file.exists() and "instance_template" not in kwargs:
            kwargs["instance_template"] = instance_file.read_text()

        super().__init__(model, env, config_class=config_class, **kwargs)
        self.ontoindex_mode = mode
        self.ontoindex_metrics = OntoIndexMetrics()

    def execute_actions(self, message: dict) -> list[dict]:
        """Execute actions with optional OntoIndex augmentation and tracking."""
        if self.config.track_ontoindex_usage:
            self._track_tool_usage(message)

        outputs = [self.env.execute(action) for action in message.get("extra", {}).get("actions", [])]

        # Augment grep/find observations in NATIVE_AUGMENT mode
        if self.ontoindex_mode == OntoIndexMode.NATIVE_AUGMENT:
            actions = message.get("extra", {}).get("actions", [])
            for i, (action, output) in enumerate(zip(actions, outputs)):
                augmented = self._maybe_augment(action, output)
                if augmented:
                    outputs[i] = augmented

        return self.add_messages(
            *self.model.format_observation_messages(message, outputs, self.get_template_vars())
        )

    def _maybe_augment(self, action: dict, output: dict) -> dict | None:
        """
        If the action is a search command (grep, find, rg, ag), augment the output
        with OntoIndex knowledge graph context.
        """
        command = action.get("command", "")
        if not command:
            return None

        pattern = self._extract_search_pattern(command)
        if not pattern or len(pattern) < self.config.augment_min_pattern_length:
            return None

        start = time.time()
        try:
            augment_result = self.env.execute({
                "command": f'ontoindex-augment "{pattern}" 2>&1 || true',
                "timeout": self.config.augment_timeout,
            })
            elapsed = time.time() - start
            self.ontoindex_metrics.augmentation_calls += 1
            self.ontoindex_metrics.augmentation_time += elapsed

            augment_text = augment_result.get("output", "").strip()
            if augment_text and "[OntoIndex]" in augment_text:
                original_output = output.get("output", "")
                output = dict(output)
                output["output"] = f"{original_output}\n\n{augment_text}"
                self.ontoindex_metrics.augmentation_hits += 1
                return output
        except Exception as e:
            logger.debug(f"Augmentation failed for pattern '{pattern}': {e}")
            self.ontoindex_metrics.augmentation_errors += 1

        return None

    @staticmethod
    def _extract_search_pattern(command: str) -> str | None:
        """Extract the search pattern from a grep/find/rg command."""
        patterns = [
            r'(?:grep|rg|ag)\s+(?:-[a-zA-Z]*\s+)*["\']([^"\']+)["\']',
            r'(?:grep|rg|ag)\s+(?:-[a-zA-Z]*\s+)*(\S+)',
        ]

        for pat in patterns:
            match = re.search(pat, command)
            if match:
                result = match.group(1)
                if result.startswith("/") or result.startswith("."):
                    continue
                if result.startswith("-"):
                    continue
                return result

        return None

    def _track_tool_usage(self, message: dict):
        """Track which OntoIndex tools the agent uses."""
        for action in message.get("extra", {}).get("actions", []):
            command = action.get("command", "")
            for key, binary in BINARIES_BY_KEY.items():
                if binary in command and key in self.ontoindex_metrics.tool_calls:
                    self.ontoindex_metrics.tool_calls[key] += 1
                    break

    def serialize(self, *extra_dicts) -> dict:
        """Serialize with OntoIndex-specific metrics."""
        ontoindex_data = {
            "info": {
                "ontoindex": {
                    "mode": self.ontoindex_mode.value,
                    "metrics": self.ontoindex_metrics.to_dict(),
                },
            },
        }
        return super().serialize(ontoindex_data, *extra_dicts)


class OntoIndexMetrics:
    """Tracks OntoIndex-specific metrics during evaluation."""

    def __init__(self):
        self.tool_calls: dict[str, int] = {key: 0 for key in TOOL_METRIC_KEYS}
        self.augmentation_calls: int = 0
        self.augmentation_hits: int = 0
        self.augmentation_errors: int = 0
        self.augmentation_time: float = 0.0
        self.index_time: float = 0.0

    @property
    def total_tool_calls(self) -> int:
        return sum(self.tool_calls.values())

    def to_dict(self) -> dict:
        return {
            "tool_calls": dict(self.tool_calls),
            "total_tool_calls": self.total_tool_calls,
            "augmentation_calls": self.augmentation_calls,
            "augmentation_hits": self.augmentation_hits,
            "augmentation_errors": self.augmentation_errors,
            "augmentation_time_seconds": round(self.augmentation_time, 2),
            "index_time_seconds": round(self.index_time, 2),
        }
