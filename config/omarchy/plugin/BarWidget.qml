import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// Baldborg — bar pill that mirrors the overlay state.
//   left click  : toggle the chat
//   right click : open the action menu
// State comes from the overlay's control socket (`bin/baldborg status`).
BarWidget {
  id: root
  moduleName: "nickmdrummer.baldborg"

  // idle | busy | muted | offline
  property string phase: "offline"
  property string language: "es"
  property bool menuOpen: false

  readonly property bool spanish: root.language !== "en"
  readonly property string label: {
    if (root.spanish) {
      return root.phase === "offline"
        ? "Baldborg no está en marcha"
        : (root.phase === "muted" ? "Baldborg · voz desactivada" : "Baldborg · clic para abrir")
    }
    return root.phase === "offline"
      ? "Baldborg is not running"
      : (root.phase === "muted" ? "Baldborg · voice off" : "Baldborg · click to open")
  }

  // The installer substitutes __REPO__ with the checkout location.
  readonly property string bin: "__REPO__/bin/baldborg"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function close() { root.menuOpen = false }

  Process {
    id: statusProc
    command: [root.bin, "status"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        const raw = String(text || "").trim()
        if (!raw) {
          root.phase = "offline"
          return
        }
        try {
          const state = JSON.parse(raw)
          root.phase = state.busy ? "busy" : (state.muted ? "muted" : "idle")
          root.language = state.language === "en" ? "en" : "es"
        } catch (error) {
          root.phase = "offline"
        }
      }
    }
  }

  Process {
    id: actionProc
    function fire(args) {
      command = [root.bin].concat(args)
      running = true
    }
  }

  Timer {
    interval: 5000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: statusProc.running = true
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.vertical ? "" : "BALDBORG"
    labelVisible: !root.vertical
    active: root.phase === "busy" || root.menuOpen
    dimmed: root.phase === "muted" || root.phase === "offline"
    tooltipText: root.label

    onPressed: function(buttonPressed) {
      if (buttonPressed === Qt.RightButton) root.menuOpen = !root.menuOpen
      else actionProc.fire(["toggle"])
    }
  }

  PopupCard {
    id: menu
    anchorItem: root
    bar: root.bar
    owner: root
    open: root.menuOpen
    contentWidth: menu.fittedContentWidth(Style.space(210))
    contentHeight: menu.fittedContentHeight(menuColumn.implicitHeight)

    Rectangle {
      anchors.fill: parent
      radius: Math.max(0, Style.cornerRadius - Style.space(2))
      color: Commons.Color.background

      Column {
        id: menuColumn
        anchors.fill: parent
        anchors.margins: Style.space(2)
        spacing: Style.space(3)

        Button {
          width: parent.width
          leftAlign: true
          text: root.spanish ? "Abrir chat" : "Open chat"
          foreground: root.bar.foreground
          onClicked: {
            root.menuOpen = false
            actionProc.fire(["open"])
          }
        }

        Button {
          width: parent.width
          leftAlign: true
          text: root.phase === "muted"
            ? (root.spanish ? "Activar voz" : "Voice on")
            : (root.spanish ? "Desactivar voz" : "Voice off")
          foreground: root.bar.foreground
          onClicked: {
            root.menuOpen = false
            actionProc.fire(["voice-toggle"])
          }
        }

        Button {
          width: parent.width
          leftAlign: true
          text: root.spanish ? "Olvidar conversación" : "Forget conversation"
          foreground: root.bar.foreground
          onClicked: {
            root.menuOpen = false
            actionProc.fire(["forget"])
          }
        }

        PanelSeparator {
          foreground: root.bar.foreground
        }

        Button {
          width: parent.width
          leftAlign: true
          text: root.spanish ? "Ocultar" : "Hide"
          foreground: root.bar.foreground
          onClicked: {
            root.menuOpen = false
            actionProc.fire(["hide"])
          }
        }

        Button {
          width: parent.width
          leftAlign: true
          text: root.spanish ? "Cerrar Baldborg" : "Quit Baldborg"
          foreground: root.bar.foreground
          onClicked: {
            root.menuOpen = false
            actionProc.fire(["quit"])
          }
        }
      }
    }
  }
}
