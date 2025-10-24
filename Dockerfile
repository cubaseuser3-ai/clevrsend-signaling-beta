FROM denoland/deno:1.45.5

WORKDIR /app

COPY signaling-server.ts .

EXPOSE 8080

CMD ["deno", "run", "--allow-net", "signaling-server.ts"]
