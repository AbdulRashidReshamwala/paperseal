package lifecycle

// BankCount is how many questions the machine's bank still holds.
func (m *Machine) BankCount() int { return m.bank.Count() }

// HeldQuestions is how many plaintext questions the machine holds for Build.
func (m *Machine) HeldQuestions() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.questions)
}
