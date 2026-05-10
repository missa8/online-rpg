#!/usr/bin/env bash
set -e

PORT="${PORT:-3000}"

cd "$(dirname "$0")"

echo "⚔  Démarrage du serveur JdR sur le port $PORT ..."
node server.js &
SERVER_PID=$!

cleanup() {
  echo ""; echo "⏹  Arrêt..."
  kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM
sleep 2

echo "🚇  Partage via localtunnel ..."
lt --port "$PORT" --print-requests &
TUNNEL_PID=$!
sleep 4

echo ""
echo "═══════════════════════════════════════"
echo "   🎯  URL locale    : http://localhost:$PORT"
echo "   🔗  Regarde les logs ci-dessus pour l'URL publique"
echo "   🗝  Mot de passe GM : ${GM_PASSWORD:-gm1234}"
echo "═══════════════════════════════════════"
echo ""
echo "Appuyez sur Ctrl+C pour arrêter."

wait "$SERVER_PID" 2>/dev/null
