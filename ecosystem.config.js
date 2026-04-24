module.exports = {
  apps: [
    {
      name: "listing-agent",
      script: "./agents/listing-agent.js",
      autorestart: true,
      out_file: "logs/listing.log",
      error_file: "logs/listing-err.log",
    },
    {
      name: "buyer-agent",
      script: "./agents/buyer-agent.js",
      autorestart: true,
      out_file: "logs/buyer.log",
      error_file: "logs/buyer-err.log",
    },
    {
      name: "rnd-scanner",
      script: "./agents/rnd-scanner.js",
      autorestart: true,
      out_file: "logs/rnd.log",
      error_file: "logs/rnd-err.log",
    },
    {
      name: "garbage-collect",
      script: "./ops/garbage-collect.js",
      cron_restart: "0 3 * * *",
      autorestart: false,
      out_file: "logs/gc.log",
      error_file: "logs/gc-err.log",
    },
  ],
}
