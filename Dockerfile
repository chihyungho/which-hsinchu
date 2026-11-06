FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
COPY data/baseline.json ./seed/baseline.json
ENV PORT=3000 DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
CMD ["sh", "-c", "[ -f /data/baseline.json ] || cp /app/seed/baseline.json /data/; node server.js"]
