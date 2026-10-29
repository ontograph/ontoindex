use ontocode_tools::code_mode_name_for_tool_name;
use ontocode_tools::direct_helper;

pub fn imported_calls() {
    code_mode_name_for_tool_name("a");
    direct_helper();
}

pub fn qualified_call() {
    ontocode_tools::direct_helper();
}
