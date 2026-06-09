async function fetchData() {
  const response = await fetch("https://api.example.com");
  return response.json();
}
