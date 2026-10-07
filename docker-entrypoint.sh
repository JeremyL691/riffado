#!/bin/sh
set -e

echo "🚀 Starting Riffado..."

echo "⏳ Running database migrations..."
bun migrate-idempotent.js

echo "🚀 Starting application..."
# Docker injects HOSTNAME with the container's IP-resolvable name. Next's
# standalone server treats that value as its bind address, which leaves
# localhost-based health checks unable to connect. Bind on all interfaces.
export HOSTNAME=0.0.0.0
exec "$@"
