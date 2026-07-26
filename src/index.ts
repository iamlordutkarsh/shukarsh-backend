import app from "./app";
import { startTrackingSync } from "./lib/tracking-sync";

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startTrackingSync();
});
