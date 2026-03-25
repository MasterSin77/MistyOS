import PresentationPage from './pages/PresentationPage'
import StudioPage from './pages/StudioPage'

function RootRouter() {
  const path = window.location.pathname.toLowerCase()

  if (path === '/studio') {
    return <StudioPage />
  }

  return <PresentationPage />
}

export default RootRouter
