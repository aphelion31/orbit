SELECT 'CREATE DATABASE orbit_pulsar'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'orbit_pulsar')\gexec

SELECT 'CREATE DATABASE orbit_saturn'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'orbit_saturn')\gexec

\connect orbit_pulsar
CREATE EXTENSION IF NOT EXISTS vector;
