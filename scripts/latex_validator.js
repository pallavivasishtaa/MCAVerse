const fs = require("fs");
const katex = require("katex");

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
};

const INPUT_FILE  = getArg("--input", "fresh_database_dump.json");
const BATCH_SIZE  = parseInt(getArg("--batch", "30"), 10);
const FILTER_IDS  = getArg("--ids", null)?.split(",").map(s => s.trim()) ?? null;
const OUTPUT_FILE = getArg("--output", INPUT_FILE.replace(".json", "_validation.json"));

function extractMath(text) {
  const results = [];
  if (!text) return results;
  const displayRe = /\$\$([\s\S]+?)\$\$/g;
  let m;
  while ((m = displayRe.exec(text)) !== null) {
    results.push({ expr: m[1], display: true, raw: m[0] });
  }
  const inlineRe = /(?<!\$)\$(?!\$)((?:[^$]|\\.)+?)(?<!\$)\$(?!\$)/g;
  while ((m = inlineRe.exec(text)) !== null) {
    results.push({ expr: m[1], display: false, raw: m[0] });
  }
  return results;
}

function validateQuestion(q) {
  const errors = [];
  const fields = {
    question_text: q.question_text ?? "",
    explanation:   q.explanation   ?? "",
  };
  (q.options ?? []).forEach((opt, i) => {
    fields[`options[${i}]`] = String(opt);
  });

  for (const [fieldName, text] of Object.entries(fields)) {
    const dollarCount = (text.match(/\$/g) || []).length;
    if (dollarCount % 2 !== 0) {
      errors.push({ field: fieldName, type: "unmatched_dollars", severity: "HIGH",
        detail: `Odd number of $ signs: ${dollarCount}` });
    }
    if (/\\left\\\\(?!begin)|\\right\\\\(?!begin)/.test(text)) {
      errors.push({ field: fieldName, type: "broken_left_right", severity: "HIGH",
        detail: "\\left or \\right followed by double-backslash" });
    }
    if (/\xa0/.test(text)) {
      errors.push({ field: fieldName, type: "nbsp_artifact", severity: "MEDIUM",
        detail: "Contains non-breaking space" });
    }
    for (const { expr, display, raw } of extractMath(text)) {
      try {
        katex.renderToString(expr, { displayMode: display, throwOnError: true, strict: false });
      } catch (err) {
        errors.push({ field: fieldName, type: "katex_parse_error", severity: "HIGH",
          expr: raw.slice(0, 80), detail: err.message?.slice(0, 120) });
      }
    }
  }
  return errors;
}

function printSummary(allResults, totalProcessed) {
  const total = allResults.length;
  const byType = {};
  for (const { errors } of allResults) {
    for (const err of errors) {
      byType[err.type] = (byType[err.type] || 0) + 1;
    }
  }
  console.log("\n" + "═".repeat(50));
  console.log("  LaTeX Validation Report");
  console.log("═".repeat(50));
  console.log(`  Questions processed  : ${totalProcessed}`);
  console.log(`  Questions with errors: ${total} (${((total/totalProcessed)*100).toFixed(1)}%)`);
  console.log("\n  By error type:");
  for (const [type, count] of Object.entries(byType).sort((a,b) => b[1]-a[1])) {
    console.log(`    ${type.padEnd(28)}: ${count}`);
  }
  if (allResults.length > 0) {
    console.log("\n  Sample errors (first 5):");
    allResults.slice(0, 5).forEach(({ id, errors }) => {
      console.log(`\n    [${id}]`);
      errors.slice(0, 2).forEach(err => {
        console.log(`      • ${err.type} in ${err.field}`);
        if (err.detail) console.log(`        ${err.detail.slice(0, 80)}`);
      });
    });
  }
  console.log("\n" + "═".repeat(50));
}

async function main() {
  console.log(`Loading ${INPUT_FILE}...`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"));
  } catch (err) {
    console.error("Failed to load input file:", err.message);
    process.exit(1);
  }
  if (!Array.isArray(data)) { console.error("Expected a JSON array."); process.exit(1); }

  const questions = FILTER_IDS ? data.filter(q => FILTER_IDS.includes(q.id)) : data;
  console.log(`Validating ${questions.length} question(s) in batches of ${BATCH_SIZE}...`);

  const allResults = [];
  const totalBatches = Math.ceil(questions.length / BATCH_SIZE);
  for (let b = 0; b < totalBatches; b++) {
    const start = b * BATCH_SIZE;
    const batch = questions.slice(start, start + BATCH_SIZE);
    process.stdout.write(`\rProcessing batch ${b+1}/${totalBatches}...`);
    for (const q of batch) {
      const errors = validateQuestion(q);
      if (errors.length > 0) allResults.push({ id: q.id, subject: q.subject, errors });
    }
  }

  printSummary(allResults, questions.length);
  const output = {
    generated_at: new Date().toISOString(),
    input_file: INPUT_FILE,
    total_processed: questions.length,
    total_with_errors: allResults.length,
    results: allResults,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
  console.log(`\n  Full results saved to: ${OUTPUT_FILE}`);
}

main().catch(err => { console.error(err); process.exit(1); });