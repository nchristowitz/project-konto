FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ src/
COPY migrations/ migrations/

RUN mkdir -p data/invoices data/estimates

EXPOSE 3000

USER node

CMD ["node", "src/server.js"]
