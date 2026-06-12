FROM node:22-alpine
RUN apk add --no-cache chromium font-freefont tzdata && \
    ln -snf /usr/share/zoneinfo/Europe/Athens /etc/localtime && \
    echo "Europe/Athens" > /etc/timezone
ENV TZ=Europe/Athens
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY bot.mjs .
CMD ["node", "bot.mjs"]
