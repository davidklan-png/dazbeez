#!/bin/bash
echo "Waiting for dazbeez-nextjs to be healthy..."
until [ "$(docker inspect --format='{{.State.Health.Status}}' \
  $(docker-compose ps -q nextjs))" = "healthy" ]; do
  sleep 2
done
echo "Ready. Starting cloudflared..."
cloudflared tunnel run <tunnel-name>
