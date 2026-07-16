"use client"

import {
    forwardRef,
    useCallback,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react"
import type {
    DrawIoEmbedProps,
    DrawIoEmbedRef,
    EventAutoSave,
    EventExport,
    EventLoad,
} from "react-drawio"

type RainToolDrawIoEmbedProps = Pick<
    DrawIoEmbedProps,
    | "autosave"
    | "baseUrl"
    | "configuration"
    | "csv"
    | "exportFormat"
    | "onAutoSave"
    | "onClose"
    | "onConfigure"
    | "onDraft"
    | "onExport"
    | "onLoad"
    | "onMerge"
    | "onPrompt"
    | "onSave"
    | "onTemplate"
    | "urlParameters"
    | "xml"
> & {
    /** Native iframe load is a reliable fallback for the Draw.io init event. */
    onIframeLoad?: () => void
}

type DrawIoMessage = {
    event?: string
    data?: string
    exit?: boolean
    message?: { parentEvent?: string }
}

function createEmbedUrl(
    baseUrl: string | undefined,
    urlParameters: DrawIoEmbedProps["urlParameters"],
) {
    const url = new URL(baseUrl ?? "https://embed.diagrams.net")
    const params = new URLSearchParams({ embed: "1", proto: "json" })
    for (const [key, value] of Object.entries(urlParameters ?? {})) {
        if (value === undefined) continue
        params.set(key, typeof value === "boolean" ? (value ? "1" : "0") : value)
    }
    url.search = params.toString()
    return url.toString()
}

/**
 * A local equivalent of react-drawio's embed component.
 *
 * The packaged Draw.io iframe can post its init event in the same event loop
 * as creation. react-drawio subscribes in a passive effect, which leaves a
 * race and an opaque empty iframe. This component subscribes in a layout
 * effect, before the browser can run the nested iframe's startup script.
 */
export const RainToolDrawIoEmbed = forwardRef<
    DrawIoEmbedRef,
    RainToolDrawIoEmbedProps
>(function RainToolDrawIoEmbed(
    {
        autosave = false,
        baseUrl,
        configuration,
        csv,
        exportFormat,
        onAutoSave,
        onClose,
        onConfigure,
        onDraft,
        onExport,
        onIframeLoad,
        onLoad,
        onMerge,
        onPrompt,
        onSave,
        onTemplate,
        urlParameters,
        xml,
    },
    ref,
) {
    const iframeRef = useRef<HTMLIFrameElement>(null)
    const [initialized, setInitialized] = useState(false)
    // Keep the iframe out of the server-rendered markup. Otherwise its local
    // init event can fire during hydration before any client listener exists.
    const [listenerReady, setListenerReady] = useState(false)

    const send = useCallback((action: string, data: object = {}) => {
        iframeRef.current?.contentWindow?.postMessage(
            JSON.stringify({ action, ...data }),
            "*",
        )
    }, [])

    const actions: DrawIoEmbedRef = useMemo(
        () => ({
            load: (data) => send("load", data),
            configure: (data) => send("configure", data),
            merge: (data) => send("merge", data),
            dialog: (data) => send("dialog", data),
            prompt: (data) => send("prompt", data),
            template: (data) => send("template", data),
            layout: (data) => send("layout", data),
            draft: (data) => send("draft", data),
            status: (data) => send("status", data),
            spinner: (data) => send("spinner", data),
            exportDiagram: (data) => send("export", data),
        }),
        [send],
    )

    useImperativeHandle(ref, () => actions, [actions])

    const handleMessage = useCallback(
        (event: MessageEvent) => {
            // The editor lives in a nested local iframe. Checking its actual
            // WindowProxy is stricter and more reliable than matching a URL
            // string (which differs between the standalone server and its
            // parent frame during startup).
            if (event.source !== iframeRef.current?.contentWindow) return

            let data: DrawIoMessage
            try {
                data = JSON.parse(event.data) as DrawIoMessage
            } catch {
                return
            }

            switch (data.event) {
                case "init":
                    setInitialized(true)
                    break
                case "load":
                    onLoad?.(data as EventLoad)
                    break
                case "autosave":
                    onAutoSave?.(data as EventAutoSave)
                    break
                case "configure":
                    if (configuration) actions.configure({ config: configuration })
                    onConfigure?.(data as never)
                    break
                case "save":
                    send("export", {
                        format: exportFormat ?? "xmlsvg",
                        exit: data.exit,
                        parentEvent: "save",
                    })
                    break
                case "exit":
                    onClose?.(data as never)
                    break
                case "draft":
                    onDraft?.(data as never)
                    break
                case "export":
                    onSave?.({
                        event: "save",
                        xml: data.data ?? "",
                        parentEvent: data.message?.parentEvent ?? "export",
                    })
                    onExport?.(data as EventExport)
                    if (data.exit) onClose?.({
                        event: "exit",
                        modified: true,
                        parentEvent: data.message?.parentEvent ?? "export",
                    })
                    break
                case "merge":
                    onMerge?.(data as never)
                    break
                case "prompt":
                    onPrompt?.(data as never)
                    break
                case "template":
                    onTemplate?.(data as never)
                    break
            }
        },
        [
            actions,
            baseUrl,
            configuration,
            exportFormat,
            onAutoSave,
            onClose,
            onConfigure,
            onDraft,
            onExport,
            onLoad,
            onMerge,
            onPrompt,
            onSave,
            onTemplate,
        ],
    )

    // Layout effects run after the iframe element is committed but before the
    // browser gets a chance to execute the local Draw.io bundle.
    useLayoutEffect(() => {
        window.addEventListener("message", handleMessage)
        setListenerReady(true)
        return () => window.removeEventListener("message", handleMessage)
    }, [handleMessage])

    useLayoutEffect(() => {
        if (!initialized) return
        if (xml) actions.load({ xml, autosave })
        else if (csv) {
            actions.load({
                descriptor: { format: "csv", data: csv },
                autosave,
            })
        } else {
            actions.load({ xml: "", autosave })
        }
    }, [actions, autosave, csv, initialized, xml])

    const iframeUrl = useMemo(
        () => createEmbedUrl(baseUrl, urlParameters),
        [baseUrl, urlParameters],
    )

    if (!listenerReady) {
        return <div className="h-full w-full" aria-label="正在初始化 Draw.io" />
    }

    return (
        <iframe
            className="diagrams-iframe"
            src={iframeUrl}
            ref={iframeRef}
            allow="clipboard-read; clipboard-write"
            title="Diagrams.net"
            onLoad={onIframeLoad}
            style={{
                width: "100%",
                height: "100%",
                minWidth: "400px",
                minHeight: "400px",
                border: "none",
            }}
        />
    )
})
