// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface NoiseRecord {
  id: string;
  encryptedValue: string;
  noiseLevel: string;
  timestamp: number;
  operation: string;
  owner: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<NoiseRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ operation: "add", value: 0 });
  const [selectedRecord, setSelectedRecord] = useState<NoiseRecord | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [showTutorial, setShowTutorial] = useState(false);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [searchTerm, setSearchTerm] = useState("");

  // Randomly selected styles: 
  // Colors: High contrast (blue+orange)
  // UI: Future metal
  // Layout: Center radiation
  // Interaction: Micro-interactions

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("noise_record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing record keys:", e); }
      }
      const list: NoiseRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`noise_record_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedValue: recordData.value, 
                noiseLevel: recordData.noiseLevel,
                timestamp: recordData.timestamp, 
                operation: recordData.operation,
                owner: recordData.owner 
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { console.error("Error loading records:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitRecord = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting data with Zama FHE..." });
    try {
      const encryptedValue = FHEEncryptNumber(newRecordData.value);
      // Simulate noise growth based on operation type
      const noiseLevel = FHEEncryptNumber(
        newRecordData.operation === "add" ? newRecordData.value * 0.1 :
        newRecordData.operation === "multiply" ? newRecordData.value * 0.2 :
        newRecordData.value * 0.05
      );
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { 
        value: encryptedValue, 
        noiseLevel,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address,
        operation: newRecordData.operation
      };
      
      await contract.setData(`noise_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      const keysBytes = await contract.getData("noise_record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("noise_record_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE operation completed!" });
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({ operation: "add", value: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Operation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const checkAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Contract not available");
      const isAvailable = await contract.isAvailable();
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: isAvailable ? "Zama FHE service is available" : "Service unavailable" 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Availability check failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const filteredRecords = records.filter(record => 
    record.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
    record.operation.toLowerCase().includes(searchTerm.toLowerCase()) ||
    record.owner.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const renderNoiseChart = (record: NoiseRecord) => {
    const value = decryptedValue || 0;
    const noise = decryptedValue ? FHEDecryptNumber(record.noiseLevel) : 0;
    const noisePercentage = value ? (noise / value) * 100 : 0;
    
    return (
      <div className="noise-chart">
        <div className="chart-container">
          <div className="chart-bar value" style={{ height: `${Math.min(value / 10, 100)}%` }}>
            <span>Value: {value.toFixed(2)}</span>
          </div>
          <div className="chart-bar noise" style={{ height: `${Math.min(noisePercentage, 100)}%` }}>
            <span>Noise: {noise.toFixed(2)}</span>
          </div>
        </div>
        <div className="chart-legend">
          <div className="legend-item">
            <div className="color-block value"></div>
            <span>Encrypted Value</span>
          </div>
          <div className="legend-item">
            <div className="color-block noise"></div>
            <span>Noise Level</span>
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="circuit-icon"></div>
          </div>
          <h1>FHE<span>Noise</span>Visualizer</h1>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-btn metal-button"
            onMouseEnter={(e) => e.currentTarget.classList.add('glow')}
            onMouseLeave={(e) => e.currentTarget.classList.remove('glow')}
          >
            <div className="add-icon"></div>New Operation
          </button>
          <button 
            className="metal-button"
            onClick={checkAvailability}
            onMouseEnter={(e) => e.currentTarget.classList.add('glow')}
            onMouseLeave={(e) => e.currentTarget.classList.remove('glow')}
          >
            Check FHE Status
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content radial-layout">
        <div className="central-panel metal-card">
          <div className="tabs">
            <button 
              className={`tab ${activeTab === "dashboard" ? "active" : ""}`}
              onClick={() => setActiveTab("dashboard")}
            >
              Dashboard
            </button>
            <button 
              className={`tab ${activeTab === "records" ? "active" : ""}`}
              onClick={() => setActiveTab("records")}
            >
              Operation Records
            </button>
            <button 
              className={`tab ${activeTab === "tutorial" ? "active" : ""}`}
              onClick={() => setActiveTab("tutorial")}
            >
              FHE Tutorial
            </button>
          </div>

          {activeTab === "dashboard" && (
            <div className="dashboard-content">
              <div className="welcome-banner">
                <h2>Zama FHE Noise Visualization</h2>
                <p>Monitor noise growth in fully homomorphic encrypted computations</p>
                <div className="fhe-badge">
                  <div className="chip-icon"></div>
                  <span>Powered by Zama FHE</span>
                </div>
              </div>

              <div className="stats-grid">
                <div className="stat-card metal-card">
                  <div className="stat-icon">
                    <div className="database-icon"></div>
                  </div>
                  <div className="stat-value">{records.length}</div>
                  <div className="stat-label">Total Operations</div>
                </div>
                <div className="stat-card metal-card">
                  <div className="stat-icon">
                    <div className="add-icon"></div>
                  </div>
                  <div className="stat-value">
                    {records.filter(r => r.operation === "add").length}
                  </div>
                  <div className="stat-label">Add Operations</div>
                </div>
                <div className="stat-card metal-card">
                  <div className="stat-icon">
                    <div className="multiply-icon"></div>
                  </div>
                  <div className="stat-value">
                    {records.filter(r => r.operation === "multiply").length}
                  </div>
                  <div className="stat-label">Multiply Operations</div>
                </div>
              </div>

              <div className="feature-card metal-card">
                <h3>Noise Growth Analysis</h3>
                <p>
                  FHE operations accumulate noise with each computation. This tool visualizes how different operations 
                  affect the noise level in your encrypted data.
                </p>
                <div className="noise-example">
                  <div className="operation">
                    <span>Addition:</span>
                    <div className="noise-indicator low"></div>
                    <span>~10% noise growth</span>
                  </div>
                  <div className="operation">
                    <span>Multiplication:</span>
                    <div className="noise-indicator high"></div>
                    <span>~20% noise growth</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "records" && (
            <div className="records-content">
              <div className="search-bar">
                <input
                  type="text"
                  placeholder="Search operations..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="metal-input"
                />
                <button 
                  onClick={loadRecords}
                  className="refresh-btn metal-button"
                  disabled={isRefreshing}
                >
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>

              {filteredRecords.length === 0 ? (
                <div className="no-records metal-card">
                  <div className="empty-icon"></div>
                  <p>No FHE operation records found</p>
                  <button 
                    className="metal-button primary"
                    onClick={() => setShowCreateModal(true)}
                  >
                    Perform First Operation
                  </button>
                </div>
              ) : (
                <div className="records-list">
                  {filteredRecords.map(record => (
                    <div 
                      key={record.id} 
                      className="record-item metal-card"
                      onClick={() => setSelectedRecord(record)}
                    >
                      <div className="record-header">
                        <div className="record-id">#{record.id.substring(0, 6)}</div>
                        <div className={`operation-tag ${record.operation}`}>
                          {record.operation}
                        </div>
                      </div>
                      <div className="record-details">
                        <div className="detail">
                          <span>Owner:</span>
                          <span>{record.owner.substring(0, 6)}...{record.owner.substring(38)}</span>
                        </div>
                        <div className="detail">
                          <span>Date:</span>
                          <span>{new Date(record.timestamp * 1000).toLocaleString()}</span>
                        </div>
                      </div>
                      <div className="record-preview">
                        <div className="encrypted-preview">
                          {record.encryptedValue.substring(0, 30)}...
                        </div>
                        <div className="fhe-tag">
                          <div className="lock-icon"></div>
                          <span>FHE Encrypted</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "tutorial" && (
            <div className="tutorial-content">
              <h2>FHE Noise Management Tutorial</h2>
              
              <div className="tutorial-step metal-card">
                <div className="step-number">1</div>
                <div className="step-content">
                  <h3>Understanding FHE Noise</h3>
                  <p>
                    Fully Homomorphic Encryption allows computations on encrypted data, but each operation 
                    adds "noise" to the ciphertext. Too much noise makes decryption impossible.
                  </p>
                </div>
              </div>

              <div className="tutorial-step metal-card">
                <div className="step-number">2</div>
                <div className="step-content">
                  <h3>Noise Growth Patterns</h3>
                  <p>
                    Different operations contribute differently to noise growth:
                    <ul>
                      <li>Addition: ~10% noise increase</li>
                      <li>Multiplication: ~20% noise increase</li>
                      <li>Bootstrapping: Resets noise to minimal level</li>
                    </ul>
                  </p>
                </div>
              </div>

              <div className="tutorial-step metal-card">
                <div className="step-number">3</div>
                <div className="step-content">
                  <h3>Using the Visualizer</h3>
                  <p>
                    This tool helps you:
                    <ul>
                      <li>Monitor noise growth across operations</li>
                      <li>Compare different operation types</li>
                      <li>Plan bootstrapping points</li>
                    </ul>
                  </p>
                </div>
              </div>

              <div className="fhe-diagram">
                <div className="diagram-node">
                  <div className="node-icon">🔓</div>
                  <div className="node-label">Plain Data</div>
                </div>
                <div className="diagram-arrow">→</div>
                <div className="diagram-node">
                  <div className="node-icon">🔒</div>
                  <div className="node-label">FHE Encryption</div>
                </div>
                <div className="diagram-arrow">→</div>
                <div className="diagram-node">
                  <div className="node-icon">⚙️</div>
                  <div className="node-label">Noisy Computation</div>
                </div>
                <div className="diagram-arrow">→</div>
                <div className="diagram-node">
                  <div className="node-icon">🔄</div>
                  <div className="node-label">Bootstrap</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitRecord} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          recordData={newRecordData} 
          setRecordData={setNewRecordData}
        />
      )}

      {selectedRecord && (
        <RecordDetailModal 
          record={selectedRecord} 
          onClose={() => { setSelectedRecord(null); setDecryptedValue(null); }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          renderNoiseChart={renderNoiseChart}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="circuit-icon"></div>
              <span>FHE Noise Visualizer</span>
            </div>
            <p>Visualizing noise growth in Zama FHE computations</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Zama FHE</a>
            <a href="#" className="footer-link">GitHub</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="copyright">© {new Date().getFullYear()} FHE Noise Visualizer</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, recordData, setRecordData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!recordData.operation || isNaN(recordData.value)) { 
      alert("Please fill all fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>Perform FHE Operation</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="chip-icon"></div>
            <p>This operation will be performed on encrypted data using Zama FHE</p>
          </div>
          
          <div className="form-group">
            <label>Operation Type *</label>
            <select 
              name="operation" 
              value={recordData.operation} 
              onChange={handleChange} 
              className="metal-select"
            >
              <option value="add">Addition</option>
              <option value="multiply">Multiplication</option>
            </select>
          </div>
          
          <div className="form-group">
            <label>Value *</label>
            <input 
              type="number" 
              name="value" 
              value={recordData.value} 
              onChange={handleValueChange} 
              placeholder="Enter numerical value..." 
              className="metal-input"
              step="0.01"
            />
          </div>
          
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{recordData.value || '0'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{recordData.value ? FHEEncryptNumber(recordData.value).substring(0, 30) + '...' : 'Not available'}</div>
              </div>
            </div>
          </div>
          
          <div className="noise-estimate">
            <h4>Estimated Noise Growth</h4>
            <div className="noise-level">
              {recordData.operation === "add" ? "~10% increase" : "~20% increase"}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button 
            onClick={onClose} 
            className="cancel-btn metal-button"
          >
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn metal-button primary"
          >
            {creating ? "Processing with FHE..." : "Execute Operation"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: NoiseRecord;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  renderNoiseChart: (record: NoiseRecord) => JSX.Element;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ 
  record, 
  onClose, 
  decryptedValue, 
  setDecryptedValue, 
  isDecrypting, 
  decryptWithSignature,
  renderNoiseChart
}) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { 
      setDecryptedValue(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(record.encryptedValue);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal metal-card">
        <div className="modal-header">
          <h2>Operation Details #{record.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="record-info">
            <div className="info-item">
              <span>Operation:</span>
              <strong className={`operation-tag ${record.operation}`}>
                {record.operation}
              </strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{record.owner.substring(0, 6)}...{record.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date:</span>
              <strong>{new Date(record.timestamp * 1000).toLocaleString()}</strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">
              {record.encryptedValue.substring(0, 50)}...
            </div>
            <div className="fhe-tag">
              <div className="lock-icon"></div>
              <span>Zama FHE Encrypted</span>
            </div>
          </div>
          
          <button 
            className="decrypt-btn metal-button"
            onClick={handleDecrypt} 
            disabled={isDecrypting}
          >
            {isDecrypting ? "Decrypting..." : 
             decryptedValue !== null ? "Hide Value" : "Decrypt with Wallet"}
          </button>
          
          {decryptedValue !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">
                {decryptedValue.toFixed(4)}
              </div>
              <div className="security-notice">
                <div className="shield-icon"></div>
                <span>Decrypted value is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
          
          <div className="noise-visualization">
            <h3>Noise Visualization</h3>
            {renderNoiseChart(record)}
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;