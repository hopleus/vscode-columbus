#!/bin/sh
# Starts the Redis Cluster and Sentinel setups of the topology tests in Docker
# and prints the environment variables that enable those tests.
# Usage: sh test/topologies.sh <work directory> >> "$GITHUB_ENV"
# Stop:  docker rm -f $(docker ps -aq --filter name=columbus-topology-)
set -eu

work=$(mkdir -p "${1:?usage: test/topologies.sh <work directory>}" && cd "$1" && pwd)
. "$(dirname "$0")/certs.sh"
image=redis:7.4-alpine
tls='--tls-ca-cert-file /work/ca.crt --tls-auth-clients no --tls-replication yes'
named='--cluster-announce-hostname node-$p --cluster-preferred-endpoint-type hostname'

run() {
	name=$1
	shift
	docker rm -f "columbus-topology-$name" >/dev/null 2>&1 || true
	docker run -d --name "columbus-topology-$name" -v "$work:/work:ro" "$@" >/dev/null
}

# cluster <name> <first port> <redis-server options, $p is the node port> [redis-cli options]
cluster() {
	name=$1
	first=$2
	ports="$first $((first + 1)) $((first + 2))"
	run "$name" -p "$first-$((first + 3)):$first-$((first + 3))" $image sh -c "
		for p in $ports; do redis-server $3 --cluster-enabled yes --cluster-config-file /tmp/nodes-\$p.conf --cluster-announce-ip 127.0.0.1 --cluster-port \$((p+1000)) --daemonize yes; done
		sleep 1
		yes yes | redis-cli ${4:-} --cluster create $(for p in $ports; do printf '127.0.0.1:%s ' "$p"; done) --cluster-replicas 0
		tail -f /dev/null"
}

# sentinel <name> <port range> <server command> <docker options> <sentinel.conf lines...>
sentinel() {
	name=$1
	range=$2
	server=$3
	options=$4
	shift 4
	printf '%s\n' "$@" > "$work/sentinel-$name.conf"
	run "$name" $options -p "$range:$range" $image sh -c "$server --daemonize yes; cp /work/sentinel-$name.conf /tmp/sentinel.conf; redis-sentinel /tmp/sentinel.conf"
}

ca "$work"
cert "$work" ip IP:127.0.0.1
for name in node-57070 node-57071 node-57072 redis-secure redis-guard; do
	cert "$work" "$name" "DNS:$name"
done

cluster cluster 57000 '--port $p'
cluster cluster-names 57020 "--port \$p $named"
cluster cluster-grow 57060 "--port \$p $named --cluster-allow-replica-migration no"
docker exec columbus-topology-cluster-grow redis-server --port 57063 --cluster-enabled yes --cluster-config-file /tmp/nodes-57063.conf --cluster-announce-ip 127.0.0.1 \
	--cluster-announce-hostname node-57063 --cluster-preferred-endpoint-type hostname --cluster-allow-replica-migration no --cluster-port 58063 --daemonize yes >/dev/null
cluster cluster-tls 57070 "--port 0 --tls-port \$p --tls-cert-file /work/node-\$p.crt --tls-key-file /work/node-\$p.key --tls-cluster yes $tls $named" '--tls --cacert /work/ca.crt'
cluster cluster-tls-ip 57080 "--port 0 --tls-port \$p --tls-cert-file /work/ip.crt --tls-key-file /work/ip.key --tls-cluster yes $tls" '--tls --cacert /work/ca.crt'

sentinel sentinel 57010-57011 'redis-server --port 57010' '' \
	'port 57011' 'sentinel monitor mymaster 127.0.0.1 57010 1'
sentinel sentinel-names 57030-57031 'redis-server --port 57030' '--add-host redis-master:127.0.0.1' \
	'port 57031' 'sentinel resolve-hostnames yes' 'sentinel announce-hostnames yes' 'sentinel monitor mymaster redis-master 57030 1'
sentinel failover 57050-57052 'redis-server --port 57050 --daemonize yes; redis-server --port 57051 --replicaof 127.0.0.1 57050' '' \
	'port 57052' 'sentinel monitor mymaster 127.0.0.1 57050 1' 'sentinel down-after-milliseconds mymaster 2000' 'sentinel failover-timeout mymaster 10000'
sentinel failover-names 57040-57042 'redis-server --port 57040 --replica-announce-ip redis-a --daemonize yes; redis-server --port 57041 --replicaof redis-a 57040 --replica-announce-ip redis-b' '--add-host redis-a:127.0.0.1 --add-host redis-b:127.0.0.1' \
	'port 57042' 'sentinel resolve-hostnames yes' 'sentinel announce-hostnames yes' 'sentinel monitor mymaster redis-a 57040 1' 'sentinel down-after-milliseconds mymaster 2000' 'sentinel failover-timeout mymaster 10000'
sentinel sentinel-tls 57090-57091 "redis-server --port 0 --tls-port 57090 --tls-cert-file /work/ip.crt --tls-key-file /work/ip.key $tls" '' \
	'port 0' 'tls-port 57091' 'tls-cert-file /work/ip.crt' 'tls-key-file /work/ip.key' 'tls-ca-cert-file /work/ca.crt' 'tls-auth-clients no' 'tls-replication yes' \
	'sentinel monitor mymaster 127.0.0.1 57090 1'
sentinel sentinel-tls-names 57092-57093 "redis-server --port 0 --tls-port 57092 --tls-cert-file /work/redis-secure.crt --tls-key-file /work/redis-secure.key $tls" '--add-host redis-secure:127.0.0.1' \
	'port 0' 'tls-port 57093' 'tls-cert-file /work/redis-guard.crt' 'tls-key-file /work/redis-guard.key' 'tls-ca-cert-file /work/ca.crt' 'tls-auth-clients no' 'tls-replication yes' \
	'sentinel resolve-hostnames yes' 'sentinel announce-hostnames yes' 'sentinel monitor mymaster redis-secure 57092 1'

for check in 'cluster 57000' 'cluster-names 57020' 'cluster-grow 57060' 'cluster-tls 57070 --tls --cacert /work/ca.crt' 'cluster-tls-ip 57080 --tls --cacert /work/ca.crt'; do
	set -- $check
	name=$1
	port=$2
	shift 2
	for _ in $(seq 1 30); do
		docker exec "columbus-topology-$name" redis-cli "$@" -p "$port" cluster info 2>/dev/null | grep -q cluster_state:ok && break
		sleep 1
	done
	docker exec "columbus-topology-$name" redis-cli "$@" -p "$port" cluster info | grep -q cluster_state:ok || {
		echo "columbus-topology-$name did not form a cluster" >&2
		exit 1
	}
done

cat <<EOF
COLUMBUS_REDIS_CLUSTER_URL=redis+cluster://127.0.0.1:57000
COLUMBUS_REDIS_SENTINEL_URL=redis+sentinel://127.0.0.1:57011/mymaster/0
COLUMBUS_REDIS_FAILOVER_URL=redis+sentinel://127.0.0.1:57052/mymaster/0
COLUMBUS_REDIS_TLS_CLUSTER_URL=rediss+cluster://127.0.0.1:57080?sslmode=verify-full
COLUMBUS_REDIS_TLS_SENTINEL_URL=rediss+sentinel://127.0.0.1:57091/mymaster/0?sslmode=verify-full
COLUMBUS_SSH_REDIS_CLUSTER_URL=redis+cluster://node-57020:57020
COLUMBUS_SSH_REDIS_SENTINEL_URL=redis+sentinel://redis-sentinel:57031/mymaster/0
COLUMBUS_SSH_REDIS_FAILOVER_URL=redis+sentinel://redis-sentinel:57042/mymaster/0
COLUMBUS_SSH_REDIS_GROW_URL=redis+cluster://node-57060:57060
COLUMBUS_SSH_REDIS_TLS_CLUSTER_URL=rediss+cluster://node-57070:57070?sslmode=verify-full
COLUMBUS_SSH_REDIS_TLS_SENTINEL_URL=rediss+sentinel://redis-guard:57093/mymaster/0?sslmode=verify-full
COLUMBUS_TOPOLOGY_CA=$work/ca.crt
EOF
