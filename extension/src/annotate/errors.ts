// Map a daemon /send failure reason to a short, human message for the toolbar.
export function sendFailureMessage(reason: string | undefined): string {
  switch (reason) {
    case 'no-route':
    case 'no-matching-route':
      return 'No route matches this tab';
    case 'no-workspace':
    case 'no-workspace-key':
    case 'no-tab':
    case 'no-pane':
      return 'Agent pane not found';
    case 'no-screenshot':
      return 'Nothing to send yet';
    case 'daemon-unreachable':
      return 'Daemon not running';
    default:
      return 'Send failed — try again';
  }
}
