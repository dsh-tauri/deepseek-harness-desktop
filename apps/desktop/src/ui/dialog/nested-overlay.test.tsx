// @vitest-environment jsdom
import type { PropsWithOverlays } from '@overlastic/react'
import { AlertDialog, Button, Modal } from '@heroui/react'
import { OverlaysProvider, useDisclosure, useOverlay } from '@overlastic/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

function Inner(props: PropsWithOverlays) {
  const disclosure = useDisclosure({ props })
  return (
    <AlertDialog isOpen={disclosure.visible} onOpenChange={disclosure.cancel}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header><AlertDialog.Heading>inner</AlertDialog.Heading></AlertDialog.Header>
            <AlertDialog.Footer><Button onPress={disclosure.cancel}>Close inner</Button></AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}

function Outer(props: PropsWithOverlays) {
  const disclosure = useDisclosure({ props })
  const openInner = useOverlay(Inner)
  return (
    <Modal isOpen={disclosure.visible} onOpenChange={disclosure.cancel}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog>
            <Modal.Header><Modal.Heading>outer</Modal.Heading></Modal.Header>
            <Modal.Body><Button onPress={() => { void openInner() }}>Open inner</Button></Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

function Launcher() {
  const openOuter = useOverlay(Outer)
  return <Button onPress={() => void openOuter()}>Open outer</Button>
}

afterEach(cleanup)

describe('nested overlays', () => {
  it('keeps the parent dialog open when the nested dialog closes', async () => {
    render(<OverlaysProvider><Launcher /></OverlaysProvider>)

    fireEvent.click(screen.getByRole('button', { name: 'Open outer' }))
    expect(await screen.findByRole('dialog', { name: 'outer' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open inner' }))
    expect(await screen.findByRole('alertdialog', { name: 'inner' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close inner' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'inner' })).toBeNull())
    expect(screen.getByRole('dialog', { name: 'outer' })).toBeTruthy()
  })
})
