const express = require("express");
const cors = require("cors");
require("dotenv").config();

const policyRoutes = require("./routes/policy");
const paymentRoutes = require("./routes/payment");
const invoiceRoutes = require("./routes/invoice");
const { LIVE } = require("./lib/chain");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", mode: LIVE ? "live" : "simulated", service: "CapX" });
});

app.use(policyRoutes);
app.use(paymentRoutes);
app.use(invoiceRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`CapX backend listening on http://localhost:${PORT}`);
  console.log(`Mode: ${LIVE ? "LIVE (X Layer)" : "SIMULATED (no chain calls)"}`);
});
