import { PageTransition } from './components/PageTransition'
import { HomePage } from './pages/home/HomePage'
import { SpendingPage } from './pages/SpendingPage'
import { SavingsPage } from './pages/savings/SavingsPage'
import { MortgagePage } from './pages/mortgage/MortgagePage'
import { ProfilePage } from './pages/ProfilePage'
import { AgentProvider } from './agent/AgentProvider'
import { BankingViewStateProvider } from './agent/BankingViewStateProvider'
import { AuthSessionProvider } from './auth/AuthProvider'
import { PersonaProvider } from './personas/PersonaProvider'
import { PageProvider, usePage, type PageId } from './pages/PageProvider'
import { ToastProvider } from './components/ToastProvider'
import { WorkbenchLayout } from './workbench/WorkbenchLayout'

function CurrentPage({ targetPage }: { targetPage: PageId }) {
  switch (targetPage) {
    case 'home':
      return <HomePage />
    case 'spending':
      return <SpendingPage />
    case 'savings':
      return <SavingsPage />
    case 'mortgage':
      return <MortgagePage />
    case 'profile':
      return <ProfilePage />
    default: {
      const _exhaustive: never = targetPage
      throw new Error(`unhandled page: ${String(_exhaustive)}`)
    }
  }
}

function BankingRoutes() {
  const { page, direction } = usePage()
  return (
    <PageTransition pageKey={page} direction={direction}>
      <CurrentPage targetPage={page} />
    </PageTransition>
  )
}

export default function App() {
  return (
    <PersonaProvider>
      <PageProvider>
        <BankingViewStateProvider>
          <AgentProvider>
            <AuthSessionProvider>
              <ToastProvider>
                <WorkbenchLayout bankingContent={<BankingRoutes />} />
              </ToastProvider>
            </AuthSessionProvider>
          </AgentProvider>
        </BankingViewStateProvider>
      </PageProvider>
    </PersonaProvider>
  )
}
