import { spawn } from "child_process";
import { parseResponseText } from "./response-line-parser.js";
import type { ClaudeSessionHandlers } from "./session.js";

const MAX_LOOP_COUNT = 5;

export class ScriptSession {
  constructor(
    private script: string,
    private workdir: string,
    private handlers: ClaudeSessionHandlers,
  ) {}

  async run(prompt: string): Promise<void> {
    await this.handlePrompt(prompt);
  }

  private async handlePrompt(prompt: string): Promise<undefined> {
    console.log("prompt: " + prompt);
    await runScript(this.script, prompt, this.workdir,
      this.onStdout.bind(this));
  }

  private async onStdout(value: string) {
    const lines = parseResponseText(value);
    await this.handlers.handleLines(lines);
  }
}

function runScript(
  script: string,
  input: string,
  cwd: string,
  onStdout: (value: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(script, [], { cwd, shell: true });
    let buffer = "";
    let stdout = "";
    let stderr = "";
    let queue = Promise.resolve();

    proc.stdin.write(input, "utf-8");
    proc.stdin.end();

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdout += text;
      buffer += text;

      // 改行区切りで分割
      const parts = buffer.split(/\r?\n/);

      // 最後は未確定なので残す
      buffer = parts.pop() ?? "";

      // queue を利用して、順番に onStdout を呼ぶことを保証する
      const data = parts.join("\n");
      queue = queue
        .then(() => onStdout(data))
        .catch(console.error);
    });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });

    proc.on("close", (code) => {
     // 残りがあれば最後に通知
      if (buffer.trim()) {
        onStdout(buffer.trim());
      }
      if (stderr) console.error(`[ScriptSession] stderr: ${stderr}`);
      if (code !== 0) {
        reject(new Error(`Script exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on("error", reject);
  });
}
