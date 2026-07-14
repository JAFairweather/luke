# Luke — the delegated-agent service + cockpit gate, as a standalone image.
# Depends only on nostr-tools + node built-ins; no app code.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY luke-service.mjs ./
COPY luke-poster.mjs ./
COPY luke-brain.mjs ./
COPY publish-profiles.mjs ./
COPY brief ./brief
ENV NODE_ENV=production
ENV LUKE_PORT=8790
EXPOSE 8790
CMD ["node", "luke-service.mjs"]
