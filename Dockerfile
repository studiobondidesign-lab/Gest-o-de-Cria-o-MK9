FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js db.js ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
