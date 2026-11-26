import readline from "node:readline";
import { CliError } from "./errors.js";

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function question(text: string, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    });

    if (hidden && process.stdout.isTTY === true) {
      process.stdout.write(text);
      const target = rl as unknown as { _writeToOutput?: (chunk: string) => void };
      target._writeToOutput = () => {};
    }

    let settled = false;
    rl.on("SIGINT", () => {
      if (settled) return;
      settled = true;
      rl.close();
      process.stdout.write("\n");
      reject(new CliError("Cancelled.", { exitCode: 130 }));
    });
    rl.on("error", (error) => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(error);
    });

    rl.question(hidden ? "" : text, (answer) => {
      if (settled) return;
      settled = true;
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

/** Prompts for a line of text. Only call this when stdin/stdout are a TTY. */
export function promptText(
  text: string,
  options: { hidden?: boolean; defaultValue?: string } = {},
): Promise<string> {
  const hint = options.defaultValue ? ` [${options.defaultValue}]` : "";
  return question(`${text}${hint}: `, options.hidden === true).then((answer) => {
    if (answer.length > 0) return answer;
    return options.defaultValue ?? "";
  });
}

export async function confirm(text: string, defaultValue = false): Promise<boolean> {
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  const answer = (await question(`${text} ${suffix}: `, false)).toLowerCase();
  if (answer.length === 0) return defaultValue;
  return answer === "y" || answer === "yes";
}

/** Reads all of stdin, used by `login --key-stdin` and piped notes. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}
