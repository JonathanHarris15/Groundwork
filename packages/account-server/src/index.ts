import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccountServer } from "./server";

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = process.env.GROUNDWORK_SITE_DIR ?? path.resolve(here, "../../site/public");
const dataFile = process.env.GROUNDWORK_DATA_FILE ?? path.resolve(process.cwd(), "data/accounts.json");
const port = Number(process.env.PORT ?? 8787);

const server = createAccountServer({ dataFile, siteDir });
server.listen(port, () => {
	console.log(`Groundwork account server at http://127.0.0.1:${port}`);
});
