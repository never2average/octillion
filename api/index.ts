// Vercel entry: the whole server as one function (vercel.json rewrites every path here). Background loops (autoscaler,
// archive) only run under `npm start`; this is for previews of the landing page, /admin, /app and /mcp.
import { createApp } from "../src/http.js";

export default createApp();
