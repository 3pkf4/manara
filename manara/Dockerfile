# لأي استضافة تقبل Docker (VPS وغيره). Render لا يحتاجه (يستعمل render.yaml مباشرة).
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY public ./public
COPY scripts ./scripts
USER node
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server/server.js"]
