FROM nginx:1.30.7-alpine

RUN addgroup -S circleit && adduser -S -u 1001 -G circleit circleit

COPY ./docker/nginx/nginx.conf /etc/nginx/nginx.conf

RUN touch /var/run/nginx.pid \
    && chown circleit:circleit /var/run/nginx.pid \
    && chown -R circleit:circleit /var/cache/nginx

USER circleit

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
