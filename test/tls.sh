#!/bin/sh
# Starts PostgreSQL, MySQL and Redis with certificates of a test CA in Docker
# and prints the environment variables that enable the TLS tests.
# The server certificate is valid for 127.0.0.1 and db-secure, not for localhost;
# the users `columbus` sign in with the client certificate; columbus-locked.key is its key with the passphrase `secret`.
# Usage: sh test/tls.sh <work directory> >> "$GITHUB_ENV"
# Stop:  docker rm -f $(docker ps -aq --filter name=columbus-tls-)
set -eu

work=$(mkdir -p "${1:?usage: test/tls.sh <work directory>}" && cd "$1" && pwd)
. "$(dirname "$0")/certs.sh"

ca "$work"
cert "$work" server IP:127.0.0.1,DNS:db-secure
cert "$work" columbus DNS:columbus
openssl pkey -in "$work/columbus.key" -aes256 -passout pass:secret -out "$work/columbus-locked.key"
chmod 644 "$work/columbus-locked.key"

run() {
	name=$1
	shift
	docker rm -f "columbus-tls-$name" >/dev/null 2>&1 || true
	docker run -d --name "columbus-tls-$name" -v "$work:/work:ro" "$@" >/dev/null
}

run postgres -e POSTGRES_PASSWORD=columbus -e POSTGRES_DB=columbus -p 55443:5432 postgres:18-alpine sh -c '
	install -o postgres -m 600 /work/server.key /tmp/server.key
	exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/work/server.crt -c ssl_key_file=/tmp/server.key -c ssl_ca_file=/work/ca.crt'
run mysql -e MYSQL_ROOT_PASSWORD=columbus -p 53316:3306 mysql:8.0 --ssl-ca=/work/ca.crt --ssl-cert=/work/server.crt --ssl-key=/work/server.key
run redis -p 56390-56391:56390-56391 redis:7.4-alpine sh -c '
	options="--port 0 --tls-cert-file /work/server.crt --tls-key-file /work/server.key --tls-ca-cert-file /work/ca.crt"
	redis-server $options --tls-port 56390 --tls-auth-clients no --daemonize yes
	exec redis-server $options --tls-port 56391 --tls-auth-clients yes'

for _ in $(seq 1 60); do
	docker exec columbus-tls-postgres pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 &&
		docker exec columbus-tls-mysql mysqladmin -uroot -pcolumbus -h 127.0.0.1 ping >/dev/null 2>&1 && break
	sleep 2
done
docker exec columbus-tls-postgres psql -U postgres -h 127.0.0.1 -c 'CREATE USER columbus' >/dev/null
docker exec columbus-tls-postgres sh -c '
	hba=$(psql -U postgres -h 127.0.0.1 -Atc "SHOW hba_file")
	{ echo "hostssl all columbus all cert"; cat "$hba"; } > /tmp/hba && cat /tmp/hba > "$hba"
	psql -U postgres -h 127.0.0.1 -c "SELECT pg_reload_conf()" >/dev/null'
docker exec columbus-tls-mysql mysql -uroot -pcolumbus -h 127.0.0.1 -e "CREATE USER 'columbus'@'%' IDENTIFIED BY 'columbus' REQUIRE X509" 2>/dev/null

cat <<EOF
COLUMBUS_TLS_CA=$work/ca.crt
COLUMBUS_TLS_CLIENT_CERT=$work/columbus.crt
COLUMBUS_TLS_CLIENT_KEY=$work/columbus.key
COLUMBUS_TLS_PG_URL=postgresql://postgres:columbus@127.0.0.1:55443/columbus
COLUMBUS_TLS_MYSQL_URL=mysql://root:columbus@127.0.0.1:53316
COLUMBUS_TLS_REDIS_URL=redis://127.0.0.1:56390/0
COLUMBUS_TLS_REDIS_CLIENT_URL=redis://127.0.0.1:56391/0
EOF
