// The app on the fixture player, for the smoke test. `?speed=` scales the event delays.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { listChains } from "@/data/chains"
import { fixtureDeps } from "@/ui/__fixtures__/player"
import App from "@/ui/App"
import "@/index.css"

const speed = Number(new URLSearchParams(window.location.search).get("speed") ?? "1")
// The real chain list, as in production: the picker and the privacy note see every chain.
const deps = fixtureDeps({ storage: window.localStorage, speed, chains: listChains() })

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App deps={deps} />
  </StrictMode>,
)
