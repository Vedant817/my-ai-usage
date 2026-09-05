FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY *.ts ./
ENV PORT=8787
EXPOSE 8787
CMD ["node", "index.ts"]
