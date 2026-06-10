export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

/**
 * Structured JSON-lines logger. Every entry carries an `event` name plus
 * arbitrary fields (the engine always includes the simulated `today`), so a
 * day's activity is greppable and machine-parseable.
 */
export class Logger {
  constructor(
    private readonly minLevel: LogLevel = "info",
    private readonly out: (line: string) => void = (line) =>
      process.stdout.write(line + "\n"),
  ) {}

  debug(event: string, fields: LogFields = {}): void {
    this.log("debug", event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.log("error", event, fields);
  }

  private log(
    level: Exclude<LogLevel, "silent">,
    event: string,
    fields: LogFields,
  ): void {
    if (this.minLevel === "silent") return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel as keyof typeof LEVEL_ORDER]) {
      return;
    }
    this.out(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        ...fields,
      }),
    );
  }
}
