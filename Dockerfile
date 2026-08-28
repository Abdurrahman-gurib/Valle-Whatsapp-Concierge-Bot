FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Application code and the assets the bot serves to guests
COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY knowledge ./knowledge
COPY assets/documents ./assets/documents
COPY assets/price-list ./assets/price-list
COPY assets/photos ./assets/photos

ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s   CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "src/server.js"]
