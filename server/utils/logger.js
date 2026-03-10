import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "../../logs");

const LOG_ENABLED = process.env.DEBUG_LOG !== "false";

// Ensure logs directory exists
if (LOG_ENABLED) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const pad = (n) => String(n).padStart(2, "0");
const pad3 = (n) => String(n).padStart(3, "0");

const timestamp = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
};

const fileTimestamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};

// Global map: requestId -> log file stream
const streams = new Map();

export const createLogger = (requestId) => {
  if (!LOG_ENABLED) {
    const noop = () => {};
    return { info: noop, warn: noop, error: noop, data: noop, close: noop, requestId };
  }

  const filename = `${fileTimestamp()}-${requestId}.log`;
  const filepath = path.join(LOG_DIR, filename);
  const stream = fs.createWriteStream(filepath, { flags: "a" });
  streams.set(requestId, { stream, filepath });

  const write = (level, context, message, obj) => {
    const ts = timestamp();
    const prefix = `[${ts}] [${level}] [${context}]`;
    const line = obj !== undefined
      ? `${prefix} ${message}\n${JSON.stringify(obj, null, 2)}\n`
      : `${prefix} ${message}\n`;
    stream.write(line);
    // Also output to console (single line for console)
    const consoleLine = obj !== undefined
      ? `${prefix} ${message} ${JSON.stringify(obj)}`
      : `${prefix} ${message}`;
    if (level === "ERROR") console.error(consoleLine);
    else if (level === "WARN") console.warn(consoleLine);
    else console.log(consoleLine);
  };

  return {
    requestId,
    info: (context, message, obj) => write("INFO", context, message, obj),
    warn: (context, message, obj) => write("WARN", context, message, obj),
    error: (context, message, obj) => write("ERROR", context, message, obj),
    data: (context, label, obj) => write("DATA", context, label, obj),
    close: () => {
      stream.end();
      streams.delete(requestId);
    },
  };
};

// Append to an existing logger by requestId (for frontend log-back)
export const appendToLog = (requestId, context, message, obj) => {
  if (!LOG_ENABLED) return false;
  const entry = streams.get(requestId);
  if (!entry) return false;
  const ts = timestamp();
  const prefix = `[${ts}] [DATA] [${context}]`;
  const line = obj !== undefined
    ? `${prefix} ${message}\n${JSON.stringify(obj, null, 2)}\n`
    : `${prefix} ${message}\n`;
  entry.stream.write(line);
  return true;
};

// Find the most recent logger if requestId not known
export const getLatestRequestId = () => {
  if (streams.size === 0) return null;
  return Array.from(streams.keys()).pop();
};
