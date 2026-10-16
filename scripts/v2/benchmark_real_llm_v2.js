require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const OpenAI = require("openai");
const {
  createEnvironment,
  runCall,
  summarizeProtocol,
} = require("./benchmark_protocol_v2");
const {
  commandOutput,
  sha256File,
  writeCsv,
  writeJson,
  writeJsonLines,
} = require("../../lib/v2/experiment-utils");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_CONFIG_PATH = path.join(
  PROJECT_ROOT,
  "experiments/v2/configs/submission-llm-20261015.json"
);

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is not configured");
  }
  if (process.env.ALLOW_PAID_LLM_EXPERIMENT !== "1") {
    throw new Error(
      "paid LLM calls are disabled; set ALLOW_PAID_LLM_EXPERIMENT=1 only after explicit approval"
    );
  }
  const configPath = path.resolve(process.argv[2] || DEFAULT_CONFIG_PATH);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const outputDirectory = path.resolve(
    process.env.EXPERIMENT_OUTPUT ||
      path.join(PROJECT_ROOT, "experiments/v2/results", config.campaignId)
  );
  const client = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: config.baseURL,
    maxRetries: 0,
    timeout: 90000,
  });
  const total = config.warmupSamples + config.measuredSamples;
  const settingId = `${config.provider}-${config.model}`;
  const environment = await createEnvironment({
    config,
    settingId,
    totalCalls: total,
  });
  const rows = [];
  fs.mkdirSync(outputDirectory, { recursive: true });
  const checkpoint = path.join(outputDirectory, "real_llm_checkpoint.jsonl");
  if (fs.existsSync(checkpoint)) throw new Error("campaign already started; preserve its records");
  try {
    for (let index = 0; index < total; index += 1) {
      process.stdout.write(`RUN real-llm ${index + 1}/${total}\n`);
      let modelMetadata;
      const row = await runCall(environment, {
          config,
          settingId,
          iteration: index + 1,
          payloadBytes: 0,
          wanRttMs: 0,
          ablation: "fair_release",
          warmup: index < config.warmupSamples,
          scenario: "real-llm-end-to-end",
          concurrency: 1,
          mode: "real-llm",
          responseFactory: async () => {
            const response = await client.chat.completions.create({
              model: config.model,
              messages: [{ role: "user", content: config.prompt }],
              temperature: config.temperature,
              max_tokens: config.maxTokens,
              thinking: { type: config.thinking },
            });
            modelMetadata = { requestedModel: config.model, returnedModel: response.model,
              responseId: response.id, usage: response.usage, finishReason: response.choices?.[0]?.finish_reason,
              thinking: config.thinking };
            const content = response.choices?.[0]?.message?.content;
            if (!content) throw new Error("LLM returned an empty response");
            return Buffer.from(content, "utf8");
          },
        });
      Object.assign(row, modelMetadata);
      rows.push(row);
      fs.appendFileSync(checkpoint, `${JSON.stringify(row)}\n`);
    }
    environment.state.assertRootInvariant(
      environment.root.capabilityCommitment
    );
  } finally {
    environment.state.close();
    fs.rmSync(environment.temporaryDirectory, { recursive: true, force: true });
  }

  const summary = summarizeProtocol(rows, []);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const rawPath = path.join(outputDirectory, "real_llm_raw.jsonl");
  const summaryJsonPath = path.join(outputDirectory, "real_llm_summary.json");
  const summaryCsvPath = path.join(outputDirectory, "real_llm_summary.csv");
  writeJsonLines(rawPath, rows);
  writeJson(summaryJsonPath, summary);
  writeCsv(summaryCsvPath, summary);
  const manifest = {
    schemaVersion: 1,
    campaignId: config.campaignId,
    campaignClass: config.campaignClass,
    generatedAt: new Date().toISOString(),
    configPath: path.relative(PROJECT_ROOT, configPath),
    configSha256: sha256File(configPath),
    git: {
      commit: commandOutput("git", ["rev-parse", "HEAD"], PROJECT_ROOT),
      branch: commandOutput("git", ["branch", "--show-current"], PROJECT_ROOT),
      trackedStatus:
        commandOutput(
          "git",
          ["status", "--porcelain", "--untracked-files=no"],
          PROJECT_ROOT
        ) || "",
    },
    host: {
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
    },
    provider: config.provider,
    model: config.model,
    paidCallsAuthorized: true,
    warmupSamples: config.warmupSamples,
    measuredSamples: config.measuredSamples,
    files: {},
  };
  for (const filePath of [rawPath, summaryJsonPath, summaryCsvPath]) {
    manifest.files[path.basename(filePath)] = {
      sha256: sha256File(filePath),
      sizeBytes: fs.statSync(filePath).size,
    };
  }
  writeJson(path.join(outputDirectory, "manifest.json"), manifest);
  console.log(`PASS real-LLM pilot: ${rows.length} paid calls`);
}

main().catch((error) => {
  console.error(error.name, error.status || "", error.message);
  process.exit(1);
});
