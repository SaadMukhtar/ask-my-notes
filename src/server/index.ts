import { config } from "../config";
import { getPool, migrate } from "../db/pool";
import { createApp } from "./app";

await migrate();
const app = createApp(getPool());
app.listen(config.port, () => {
  console.log(`Ask My Notes API on http://localhost:${config.port} (LLM_PROVIDER=${config.llmProvider}, notes: ${config.notesDir})`);
});
