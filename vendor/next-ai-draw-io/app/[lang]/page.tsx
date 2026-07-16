"use client"
// Modified by RainTool on 2026-07-16 under Apache-2.0: recognize the pinned
// desktop embedding and force the configured local draw.io editor offline.
// See ../../RAINTOOL_INTEGRATION.md and the repository third-party notices.
import { usePathname, useRouter } from "next/navigation"
import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import type { ImperativePanelHandle } from "react-resizable-panels"
import ChatPanel from "@/components/chat-panel"
import { RainToolDrawIoEmbed } from "@/components/raintool-drawio-embed"
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable"
import { useDiagram } from "@/contexts/diagram-context"
import { type DrawioTheme, isDrawioTheme } from "@/lib/drawio-themes"
import { i18n, type Locale } from "@/lib/i18n/config"
import { getAllSessionMetadata, getSession } from "@/lib/session-storage"

export default function Home() {
    const {
        drawioRef,
        handleDiagramExport,
        handleDiagramAutoSave,
        loadDiagram,
        onDrawioLoad,
        resetDrawioReady,
    } = useDiagram()
    const router = useRouter()
    const pathname = usePathname()
    // Extract current language from pathname (e.g., "/zh/about" → "zh")
    const currentLang = (pathname.split("/")[1] || i18n.defaultLocale) as Locale
    const [isMobile, setIsMobile] = useState(false)
    const [isChatVisible, setIsChatVisible] = useState(true)
    const [drawioUi, setDrawioUi] = useState<DrawioTheme>("kennedy")
    const [darkMode, setDarkMode] = useState(false)
    const [isLoaded, setIsLoaded] = useState(false)
    const [isDrawioReady, setIsDrawioReady] = useState(false)
    const [isElectron, setIsElectron] = useState(false)
    const [drawioBaseUrl, setDrawioBaseUrl] = useState(
        process.env.NEXT_PUBLIC_DRAWIO_BASE_URL || "https://embed.diagrams.net",
    )
    const rainToolEmbedded =
        process.env.NEXT_PUBLIC_RAINTOOL_EMBEDDED === "true"

    const chatPanelRef = useRef<ImperativePanelHandle>(null)
    const isMobileRef = useRef(false)
    const hasDrawioReadyRef = useRef(false)
    const activeRainToolDiagramIdRef = useRef<string | null>(null)
    const pendingRainToolExportRef = useRef<{
        requestId: string
        format: "png" | "svg"
    } | null>(null)

    const postToRainTool = useCallback(
        (message: Record<string, unknown>) => {
            if (!rainToolEmbedded || window.parent === window) return
            window.parent.postMessage(
                { protocol: "raintool-diagram-v1", ...message },
                "*",
            )
        },
        [rainToolEmbedded],
    )

    // Load preferences from localStorage after mount
    useEffect(() => {
        // Restore saved locale and redirect if needed
        const savedLocale = localStorage.getItem("next-ai-draw-io-locale")
        if (savedLocale && i18n.locales.includes(savedLocale as Locale)) {
            const pathParts = pathname.split("/").filter(Boolean)
            const currentLocale = pathParts[0]
            if (currentLocale !== savedLocale) {
                pathParts[0] = savedLocale
                router.replace(`/${pathParts.join("/")}`)
                return // Wait for redirect
            }
        }

        const savedUi = localStorage.getItem("drawio-theme")
        if (isDrawioTheme(savedUi)) {
            setDrawioUi(savedUi)
        }

        const savedDarkMode = localStorage.getItem("next-ai-draw-io-dark-mode")
        if (savedDarkMode !== null) {
            const isDark = savedDarkMode === "true"
            setDarkMode(isDark)
            document.documentElement.classList.toggle("dark", isDark)
        } else {
            const prefersDark = window.matchMedia(
                "(prefers-color-scheme: dark)",
            ).matches
            setDarkMode(prefersDark)
            document.documentElement.classList.toggle("dark", prefersDark)
        }

        // Detect Electron and use bundled draw.io files for offline use
        // Note: react-drawio uses `new URL(baseUrl)` so we need absolute URL
        // Include /index.html because Next.js doesn't auto-serve index.html for directories
        const electronDetected =
            rainToolEmbedded ||
            (!process.env.NEXT_PUBLIC_DRAWIO_BASE_URL &&
                !!(window as unknown as { electronAPI?: unknown }).electronAPI)
        if (electronDetected) {
            setIsElectron(true)
            setDrawioBaseUrl(
                process.env.NEXT_PUBLIC_DRAWIO_BASE_URL ||
                    `${window.location.origin}/drawio/index.html`,
            )
        }

        setIsLoaded(true)
    }, [pathname, router])

    const handleDrawioLoad = useCallback(() => {
        if (hasDrawioReadyRef.current) return
        hasDrawioReadyRef.current = true
        setIsDrawioReady(true)
        onDrawioLoad()
        postToRainTool({ type: "raintool:diagram-ready" })
    }, [onDrawioLoad, postToRainTool])

    // A locally packaged iframe can finish before Electron reports its native
    // load event. Do not leave the editor hidden forever in that case: the
    // bridge load below is still safe because Draw.io accepts it once ready.
    useEffect(() => {
        if (!isLoaded || isDrawioReady) return
        const fallback = window.setTimeout(handleDrawioLoad, 3000)
        return () => window.clearTimeout(fallback)
    }, [handleDrawioLoad, isDrawioReady, isLoaded])

    const handleEmbeddedAutoSave = useCallback(
        (data: { xml?: string }) => {
            handleDiagramAutoSave(data)
            if (data.xml && activeRainToolDiagramIdRef.current) {
                postToRainTool({
                    type: "raintool:diagram-autosave",
                    diagramId: activeRainToolDiagramIdRef.current,
                    xml: data.xml,
                })
            }
        },
        [handleDiagramAutoSave, postToRainTool],
    )

    const handleEmbeddedExport = useCallback(
        (data: { data?: string }) => {
            const pending = pendingRainToolExportRef.current
            if (pending) {
                pendingRainToolExportRef.current = null
                postToRainTool({
                    type: "raintool:diagram-export-result",
                    requestId: pending.requestId,
                    data: data.data,
                })
                return
            }
            handleDiagramExport(data)
        },
        [handleDiagramExport, postToRainTool],
    )

    // RainTool parent bridge: load external documents, export current canvas,
    // and migrate legacy IndexedDB diagrams without exposing chat messages.
    useEffect(() => {
        if (!rainToolEmbedded || window.parent === window) return
        const handleMessage = (event: MessageEvent) => {
            if (event.source !== window.parent) return
            const message = event.data as Record<string, unknown> | null
            if (!message || message.protocol !== "raintool-diagram-v1") return
            if (
                message.type === "raintool:diagram-load" &&
                typeof message.diagramId === "string" &&
                typeof message.xml === "string"
            ) {
                activeRainToolDiagramIdRef.current = message.diagramId
                loadDiagram(message.xml, true)
                postToRainTool({
                    type: "raintool:diagram-loaded",
                    diagramId: message.diagramId,
                    revision: message.revision,
                })
                return
            }
            if (
                message.type === "raintool:diagram-export" &&
                typeof message.requestId === "string" &&
                (message.format === "png" || message.format === "svg")
            ) {
                pendingRainToolExportRef.current = {
                    requestId: message.requestId,
                    format: message.format,
                }
                drawioRef.current?.exportDiagram({ format: message.format })
                return
            }
            if (message.type === "raintool:legacy-request") {
                void (async () => {
                    const metadata = await getAllSessionMetadata()
                    const items: Array<{
                        legacySessionId: string
                        title: string
                        xml: string
                        createdAt: number
                        updatedAt: number
                    }> = []
                    for (const item of metadata) {
                        if (!item.hasDiagram) continue
                        const session = await getSession(item.id)
                        if (!session?.diagramXml) continue
                        items.push({
                            legacySessionId: session.id,
                            title: session.title,
                            xml: session.diagramXml,
                            createdAt: session.createdAt,
                            updatedAt: session.updatedAt,
                        })
                    }
                    postToRainTool({
                        type: "raintool:legacy-response",
                        items,
                    })
                })()
            }
        }
        window.addEventListener("message", handleMessage)
        return () => window.removeEventListener("message", handleMessage)
    }, [drawioRef, loadDiagram, postToRainTool, rainToolEmbedded])

    const handleDarkModeChange = () => {
        const newValue = !darkMode
        setDarkMode(newValue)
        localStorage.setItem("next-ai-draw-io-dark-mode", String(newValue))
        document.documentElement.classList.toggle("dark", newValue)
        hasDrawioReadyRef.current = false
        setIsDrawioReady(false)
        resetDrawioReady()
    }

    const handleDrawioUiChange = (theme: DrawioTheme) => {
        localStorage.setItem("drawio-theme", theme)
        setDrawioUi(theme)
        hasDrawioReadyRef.current = false
        setIsDrawioReady(false)
        resetDrawioReady()
    }

    // Check mobile - reset draw.io before crossing breakpoint
    const isInitialRenderRef = useRef(true)
    useEffect(() => {
        const checkMobile = () => {
            const newIsMobile = window.innerWidth < 768
            if (
                !isInitialRenderRef.current &&
                newIsMobile !== isMobileRef.current
            ) {
                hasDrawioReadyRef.current = false
                setIsDrawioReady(false)
                resetDrawioReady()
            }
            isMobileRef.current = newIsMobile
            isInitialRenderRef.current = false
            setIsMobile(newIsMobile)
        }

        checkMobile()
        window.addEventListener("resize", checkMobile)
        return () => window.removeEventListener("resize", checkMobile)
    }, [resetDrawioReady])

    const toggleChatPanel = () => {
        const panel = chatPanelRef.current
        if (panel) {
            if (panel.isCollapsed()) {
                panel.expand()
                setIsChatVisible(true)
            } else {
                panel.collapse()
                setIsChatVisible(false)
            }
        }
    }

    // Keyboard shortcut for toggling chat panel
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "b") {
                event.preventDefault()
                toggleChatPanel()
            }
        }

        window.addEventListener("keydown", handleKeyDown)
        return () => window.removeEventListener("keydown", handleKeyDown)
    }, [])

    return (
        <div className="h-screen bg-background relative overflow-hidden">
            <ResizablePanelGroup
                id="main-panel-group"
                direction={isMobile ? "vertical" : "horizontal"}
                className="h-full"
            >
                <ResizablePanel
                    id="drawio-panel"
                    defaultSize={isMobile ? 50 : 67}
                    minSize={20}
                >
                    <div
                        className={`h-full relative ${
                            isMobile ? "p-1" : "p-2"
                        }`}
                    >
                        <div className="h-full rounded-xl overflow-hidden shadow-soft-lg border border-border/30 relative">
                            {isLoaded && (
                                <div
                                    className={`h-full w-full ${isDrawioReady ? "" : "invisible absolute inset-0"}`}
                                >
                                    <RainToolDrawIoEmbed
                                        key={`${drawioUi}-${darkMode}-${currentLang}-${isElectron}`}
                                        ref={drawioRef}
                                        autosave
                                        onIframeLoad={handleDrawioLoad}
                                        onAutoSave={handleEmbeddedAutoSave}
                                        onExport={handleEmbeddedExport}
                                        onLoad={handleDrawioLoad}
                                        baseUrl={drawioBaseUrl}
                                        urlParameters={{
                                            ui: drawioUi,
                                            spin: false,
                                            libraries: false,
                                            saveAndExit: false,
                                            noSaveBtn: true,
                                            noExitBtn: true,
                                            dark:
                                                darkMode || drawioUi === "dark",
                                            lang: currentLang,
                                            // Enable offline mode in Electron to disable external service calls
                                            ...(isElectron && {
                                                offline: true,
                                            }),
                                        }}
                                    />
                                </div>
                            )}
                            {(!isLoaded || !isDrawioReady) && (
                                <div className="h-full w-full bg-background flex items-center justify-center">
                                    <span className="text-muted-foreground">
                                        Draw.io panel is loading...
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                </ResizablePanel>

                <ResizableHandle withHandle />

                {/* Chat Panel */}
                <ResizablePanel
                    key={isMobile ? "mobile" : "desktop"}
                    id="chat-panel"
                    ref={chatPanelRef}
                    defaultSize={isMobile ? 50 : 33}
                    minSize={isMobile ? 20 : 15}
                    maxSize={isMobile ? 80 : 50}
                    collapsible={!isMobile}
                    collapsedSize={isMobile ? 0 : 3}
                    onCollapse={() => setIsChatVisible(false)}
                    onExpand={() => setIsChatVisible(true)}
                >
                    <div className={`h-full ${isMobile ? "p-1" : "py-2 pr-2"}`}>
                        <Suspense
                            fallback={
                                <div className="h-full bg-card rounded-xl border border-border/30 flex items-center justify-center text-muted-foreground">
                                    Loading chat...
                                </div>
                            }
                        >
                            <ChatPanel
                                isVisible={isChatVisible}
                                onToggleVisibility={toggleChatPanel}
                                drawioUi={drawioUi}
                                onDrawioUiChange={handleDrawioUiChange}
                                darkMode={darkMode}
                                onToggleDarkMode={handleDarkModeChange}
                                isMobile={isMobile}
                            />
                        </Suspense>
                    </div>
                </ResizablePanel>
            </ResizablePanelGroup>
        </div>
    )
}
