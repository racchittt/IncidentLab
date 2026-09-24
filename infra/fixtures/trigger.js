// infra/fixtures/trigger.js
const fs = require("fs");
const path = require("path");

const fixtureName = process.argv[2];
if (!fixtureName) {
  console.error("Usage: node trigger.js <fixture-name>");
  process.exit(1);
}

const filePath = path.join(__dirname, `${fixtureName}.json`);
const fixture = JSON.parse(fs.readFileSync(filePath, "utf-8"));

const url = `http://localhost:8080${fixture.target_endpoint}`;

fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(fixture.params),
})
  .then((res) => {
    console.log(`Triggered ${fixture.id}: ${fixture.name} → status ${res.status}`);
  })
  .catch((err) => {
    console.error("Failed to trigger fixture:", err.message);
  });