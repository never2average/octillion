# Octillion server: landing page, MCP endpoint, orchestrator worker API.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3333
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY sql ./sql
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY harnesses ./harnesses
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3333/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Plain node (not npx) so SIGTERM reaches the server; run with an init (compose `init: true`) as PID 1.
CMD ["node", "--import", "tsx", "src/http.ts"]
