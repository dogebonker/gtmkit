# gtmkit serve --public: HTTP MCP at /mcp, the dashboard and /health on port 8787. TLS comes from the platform's proxy.
FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY plugin ./plugin
RUN printf '#!/bin/sh\nexec bun /app/src/edge/cli/main.ts "$@"\n' > /usr/local/bin/gtmkit \
  && chmod 755 /usr/local/bin/gtmkit \
  && mkdir /data && chown bun:bun /data
# The SQLite file lives at /data/gtmkit.db. Credentials come from the environment, never from the image.
ENV GTMKIT_HOME=/data
VOLUME /data
USER bun
EXPOSE 8787
CMD ["gtmkit", "serve", "--public", "--port", "8787"]
