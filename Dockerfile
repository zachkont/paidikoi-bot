FROM node:24-alpine
RUN apk add --no-cache chromium font-freefont tzdata && \
    ln -snf /usr/share/zoneinfo/Europe/Athens /etc/localtime && \
    echo "Europe/Athens" > /etc/timezone
ENV TZ=Europe/Athens
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY bot.mjs .
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "bot.mjs"]
