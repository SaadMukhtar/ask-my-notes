import { closePools, migrate } from "./pool";

await migrate();
console.log("schema applied");
await closePools();
