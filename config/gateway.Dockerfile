FROM node:24.12.0-alpine3.21 AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace=@contracts/web --include-workspace-root
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN npm run build --workspace=@contracts/web

FROM nginx:1.27.4-alpine3.21
COPY config/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
