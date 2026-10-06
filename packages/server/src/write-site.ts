import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePublicFiles } from "./site-pages";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
writePublicFiles(publicDir);
