FROM node:20-alpine

WORKDIR /app
# Install deps first so a code change does not re-run npm install.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY web ./web

# Subscriptions live here; mount it so they survive a rebuild.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV NODE_ENV=production PORT=8082 DATA_DIR=/app/data
EXPOSE 8082
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+(process.env.BASE_PATH||'')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
