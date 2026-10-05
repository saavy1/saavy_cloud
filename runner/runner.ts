// The desktop runner on its own, for a machine where no front end is open (a service, a second computer).
//
//   SAAVY_URL=https://… SAAVY_TOKEN=… node runner/runner.ts
import { startRunner } from "./link.ts";

const url = process.env.SAAVY_URL;
const token = process.env.SAAVY_TOKEN;
if (url === undefined || token === undefined) {
	console.error("runner: set SAAVY_URL and SAAVY_TOKEN");
	process.exit(2);
}
startRunner({ url: url.replace(/\/ws\/runner$/, ""), token, log: (line) => console.log(line) });
