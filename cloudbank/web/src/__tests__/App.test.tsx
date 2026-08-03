import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../App'

describe('App', () => {
  it('mounts and renders the header brand', () => {
    render(<App />)
    expect(screen.getByText('Cloudbank')).toBeInTheDocument()
  })
  it('renders the Home tab label', () => {
    render(<App />)
    expect(screen.getAllByText('Home').length).toBeGreaterThan(0)
  })
})
