FROM node:23-alpine
WORKDIR /app
COPY . .
RUN rm -f .env
RUN npm install
RUN npm install -g nodemon ts-node # Install nodemon and ts-node globally
EXPOSE 8080
CMD ["nodemon", "--exec", "ts-node", "./src/app.ts"] # Use ts-node with nodemon