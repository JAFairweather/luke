# Luke — the delegated-agent service + cockpit gate, as a standalone image.
# Depends only on nostr-tools + node built-ins; no app code.
FROM node:22-alpine
WORKDIR /app
# git: the Console commits each config edit to Luke's workspace repo.
RUN apk add --no-cache git
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY luke-service.mjs ./
COPY luke-poster.mjs ./
COPY luke-console.mjs ./
COPY luke-skin.mjs ./
COPY luke-reveal.mjs ./
COPY luke-brain.mjs ./
COPY luke-calendar.mjs ./
COPY luke-morning.mjs ./
COPY publish-profiles.mjs ./
COPY brief ./brief
ENV NODE_ENV=production
ENV LUKE_PORT=8790
EXPOSE 8790
CMD ["node", "luke-service.mjs"]
