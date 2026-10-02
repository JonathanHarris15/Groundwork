FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci && npm run build -w packages/server && npm prune --omit=dev
ENV PORT=8080
EXPOSE 8080
CMD ["node", "packages/server/dist/server.js"]
