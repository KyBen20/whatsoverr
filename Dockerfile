FROM node:20-alpine

# Dependances minimales pour les modules natifs de Baileys
RUN apk add --no-cache python3 make g++ git

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

# Dossiers de persistance (montes en volumes via docker-compose)
RUN mkdir -p /usr/src/app/auth_info /usr/src/app/data

EXPOSE 3000

CMD ["node", "server.js"]