// Dev-only helper: parse-validate the inline <script> embedded in src/ui.ts.
// Run: bun run scripts/check-ui.ts
const src = await Bun.file(new URL("../src/ui.ts", import.meta.url)).text();
const m = /<script>([\s\S]*?)<\/script>/.exec(src);
if (!m) throw new Error("ui.ts: no <script> block found");
new Function(m[1]!); // throws on syntax error
console.log("ui inline JS: parses OK");
